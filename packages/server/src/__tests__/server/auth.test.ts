import { describe, it, expect } from "vitest";
import { _internal } from "../../auth.js";

const { isValidApiKey, isAuthExempt } = _internal;

describe("isValidApiKey", () => {
  it("rejects undefined", () => {
    expect(isValidApiKey(undefined, "abc123")).toBe(false);
  });

  it("rejects array (multi-value header)", () => {
    expect(isValidApiKey(["abc", "def"] as unknown as string, "abc123")).toBe(false);
  });

  it("rejects mismatched length", () => {
    expect(isValidApiKey("short", "much-longer-key")).toBe(false);
  });

  it("rejects mismatched value of same length", () => {
    expect(isValidApiKey("aaaaaa", "bbbbbb")).toBe(false);
  });

  it("accepts exact match", () => {
    expect(isValidApiKey("secret", "secret")).toBe(true);
  });

  it("accepts long secrets", () => {
    const key = "a".repeat(64);
    expect(isValidApiKey(key, key)).toBe(true);
  });
});

describe("isAuthExempt", () => {
  it("exempts GET /health", () => {
    expect(isAuthExempt("GET", "/health")).toBe(true);
  });

  it("exempts GET /health/deep", () => {
    expect(isAuthExempt("GET", "/health/deep")).toBe(true);
  });

  it("exempts GET /api/discovery", () => {
    expect(isAuthExempt("GET", "/api/discovery")).toBe(true);
  });

  it("exempts GET /ws", () => {
    expect(isAuthExempt("GET", "/ws")).toBe(true);
  });

  it("does NOT exempt POST /health (only GET)", () => {
    expect(isAuthExempt("POST", "/health")).toBe(false);
  });

  it("exempts hook callback paths from LOOPBACK only", () => {
    const LO = "127.0.0.1";
    expect(isAuthExempt("POST", "/api/hooks/pre-tool", LO)).toBe(true);
    expect(isAuthExempt("POST", "/api/hooks/post-tool", LO)).toBe(true);
    expect(isAuthExempt("POST", "/api/hooks/pre-compact", LO)).toBe(true);
    expect(isAuthExempt("POST", "/api/hooks/stop", LO)).toBe(true);
    expect(isAuthExempt("POST", "/api/sessions/register", LO)).toBe(true);
    expect(isAuthExempt("POST", "/api/sessions/drain", LO)).toBe(true);
    expect(isAuthExempt("POST", "/api/hooks/pre-tool", "::1")).toBe(true);
    expect(isAuthExempt("POST", "/api/hooks/pre-tool", "::ffff:127.0.0.1")).toBe(true);
  });

  it("REQUIRES the key for hook/mutating paths from the LAN (2026-08-06 review: unauthenticated RCE surface)", () => {
    const LAN = "192.168.1.50";
    expect(isAuthExempt("POST", "/api/hooks/pre-tool", LAN)).toBe(false);
    expect(isAuthExempt("POST", "/api/sessions/register", LAN)).toBe(false);
    expect(isAuthExempt("POST", "/api/mcp", LAN)).toBe(false);
    expect(isAuthExempt("POST", "/api/sessions/abc/decide-next", LAN)).toBe(false);
    expect(isAuthExempt("POST", "/api/sessions/abc/schedule-wake", LAN)).toBe(false);
    expect(isAuthExempt("POST", "/api/brain/hook-ingest/transcript", LAN)).toBe(false);
    // No source ip at all (unknown) → treated as untrusted.
    expect(isAuthExempt("POST", "/api/mcp")).toBe(false);
  });

  it("exempts the MCP endpoint from loopback (transport owns the handshake)", () => {
    expect(isAuthExempt("POST", "/api/mcp", "127.0.0.1")).toBe(true);
  });

  it("read-only probes stay exempt regardless of source", () => {
    expect(isAuthExempt("GET", "/health", "192.168.1.50")).toBe(true);
    expect(isAuthExempt("GET", "/api/discovery", "192.168.1.50")).toBe(true);
  });

  it("does NOT exempt hook management routes", () => {
    expect(isAuthExempt("POST", "/api/hooks/install")).toBe(false);
    expect(isAuthExempt("POST", "/api/hooks/uninstall")).toBe(false);
    expect(isAuthExempt("GET", "/api/hooks/status")).toBe(false);
  });

  it("exempts decide-next sub-route per session (loopback)", () => {
    expect(isAuthExempt("POST", "/api/sessions/abc-xyz/decide-next", "127.0.0.1")).toBe(true);
    expect(isAuthExempt("POST", "/api/sessions/123/decide-next", "127.0.0.1")).toBe(true);
  });

  it("does NOT exempt decide-next-LIKE paths", () => {
    expect(isAuthExempt("POST", "/api/sessions/abc/decide-next/extra")).toBe(false);
    expect(isAuthExempt("POST", "/api/sessions//decide-next")).toBe(false);
  });

  it("does NOT exempt other session sub-routes", () => {
    expect(isAuthExempt("POST", "/api/sessions/abc/intervene")).toBe(false);
    expect(isAuthExempt("GET", "/api/sessions/abc")).toBe(false);
  });

  it("does NOT exempt random paths", () => {
    expect(isAuthExempt("GET", "/api/orgs")).toBe(false);
    expect(isAuthExempt("POST", "/api/sessions")).toBe(false);
  });
});
