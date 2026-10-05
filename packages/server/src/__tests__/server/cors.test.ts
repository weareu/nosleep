import { describe, it, expect } from "vitest";

/**
 * Mirrors the CORS origin validator from server.ts. Tests the policy in
 * isolation so we don't have to bring up the whole server with all routes.
 * Keep this in lockstep with the real implementation.
 */
const ALLOWED_CORS_PORTS = new Set([5173, 3777, 19006]);

function corsValidator(origin: string | undefined): { allowed: boolean | null; error: Error | null } {
  let result: { allowed: boolean | null; error: Error | null } = { allowed: null, error: null };
  const cb = (err: Error | null, allowed?: boolean): void => {
    result = { allowed: allowed ?? false, error: err };
  };

  if (!origin) {
    cb(null, true);
    return result;
  }
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      cb(null, false);
      return result;
    }
    const port = parsed.port ? parseInt(parsed.port, 10) : (parsed.protocol === "https:" ? 443 : 80);
    cb(null, ALLOWED_CORS_PORTS.has(port));
  } catch {
    cb(null, false);
  }
  return result;
}

describe("CORS origin validator", () => {
  it("allows localhost on dashboard port (5173)", () => {
    expect(corsValidator("http://localhost:5173").allowed).toBe(true);
  });

  it("allows localhost on server port (3777)", () => {
    expect(corsValidator("http://localhost:3777").allowed).toBe(true);
  });

  it("allows expo dev port (19006)", () => {
    expect(corsValidator("http://localhost:19006").allowed).toBe(true);
  });

  it("allows LAN IP on dashboard port", () => {
    expect(corsValidator("http://192.168.1.42:5173").allowed).toBe(true);
  });

  it("allows Tailscale IP on dashboard port", () => {
    expect(corsValidator("http://100.64.0.7:5173").allowed).toBe(true);
  });

  it("allows LAN IP on server port", () => {
    expect(corsValidator("http://192.168.1.42:3777").allowed).toBe(true);
  });

  it("rejects unknown port even on localhost", () => {
    expect(corsValidator("http://localhost:9999").allowed).toBe(false);
  });

  it("rejects port 80 (default http)", () => {
    expect(corsValidator("http://example.com").allowed).toBe(false);
  });

  it("rejects port 443 (default https)", () => {
    expect(corsValidator("https://example.com").allowed).toBe(false);
  });

  it("rejects non-http(s) protocols", () => {
    expect(corsValidator("file:///tmp/bad.html").allowed).toBe(false);
    expect(corsValidator("ftp://example.com:5173").allowed).toBe(false);
  });

  it("rejects malformed origin string", () => {
    expect(corsValidator("not a url").allowed).toBe(false);
  });

  it("allows undefined origin (same-origin / non-browser)", () => {
    expect(corsValidator(undefined).allowed).toBe(true);
  });

  it("port from URL takes precedence over protocol default", () => {
    // Even an HTTPS origin on port 5173 is allowed (uncommon but possible)
    expect(corsValidator("https://192.168.1.10:5173").allowed).toBe(true);
  });
});
