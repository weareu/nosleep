/**
 * Phase 12 — SSRF guard. Blocks fetches to private/loopback/link-local/
 * cloud-metadata IPs. Used by both url-fetcher-ref and url-fetcher-full.
 *
 * Resolves the URL's hostname via DNS and rejects when ANY resolved IP is
 * unsafe. Re-checked after every redirect by passing `redirect: "manual"`
 * and walking each Location header through this guard.
 */

import { lookup } from "node:dns/promises";

export class SsrfBlockedError extends Error {
  constructor(
    public reason: string,
    public details: Record<string, unknown> = {},
  ) {
    super(`SSRF blocked: ${reason}`);
    this.name = "SsrfBlockedError";
  }
}

const PRIVATE_V4_RANGES: Array<[number, number, number]> = [
  [10, 0, 8], // 10.0.0.0/8
  [172, 16, 12], // 172.16.0.0/12
  [192, 168, 16], // 192.168.0.0/16
  [127, 0, 8], // 127.0.0.0/8 loopback
  [169, 254, 16], // 169.254.0.0/16 link-local + cloud metadata
  [100, 64, 10], // 100.64.0.0/10 carrier-grade NAT
  [0, 0, 8], // 0.0.0.0/8
];

function ipToInt(ip: string): number | null {
  const parts = ip.split(".").map((p) => Number(p));
  if (parts.length !== 4) return null;
  if (parts.some((p) => !Number.isFinite(p) || p < 0 || p > 255)) return null;
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

function isPrivateV4(ip: string): boolean {
  const intIp = ipToInt(ip);
  if (intIp === null) return true; // unparseable → reject
  for (const [a, b, prefix] of PRIVATE_V4_RANGES) {
    const networkBase = (a << 24) + (b << 16);
    const mask = ~((1 << (32 - prefix)) - 1) >>> 0;
    if (((intIp & mask) >>> 0) === ((networkBase & mask) >>> 0)) return true;
  }
  return false;
}

function isPrivateV6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::1" || lower === "::") return true;
  if (lower.startsWith("fe80:") || lower.startsWith("fe80::")) return true; // link-local
  if (/^fc[0-9a-f]{2}:/.test(lower) || /^fd[0-9a-f]{2}:/.test(lower)) return true; // unique local
  if (lower.startsWith("::ffff:")) {
    // IPv4-mapped → check the v4 portion
    const v4 = lower.replace(/^::ffff:/, "");
    if (v4.includes(".")) return isPrivateV4(v4);
  }
  return false;
}

/** NOSLEEP_URL_FETCH_ALLOW_HOSTS — comma-separated hostnames/IPs exempt
 *  from the private-address block. Read per call so tests can set it. */
function allowedHosts(): Set<string> {
  const raw = process.env.NOSLEEP_URL_FETCH_ALLOW_HOSTS ?? "";
  return new Set(
    raw
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
  );
}

/**
 * Resolve the hostname and assert every result IP is publicly routable.
 * Throws SsrfBlockedError on any private/loopback/link-local/metadata hit.
 * Returns the resolved IP (caller may pin connections to it to defeat
 * DNS rebinding — out of scope for v1).
 */
export async function assertPublicHost(url: string): Promise<string> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SsrfBlockedError("invalid_url", { url });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new SsrfBlockedError("scheme_not_allowed", { scheme: parsed.protocol });
  }

  const host = parsed.hostname;
  // Operator opt-in for intranet / local sources (and loopback test
  // fixtures): exact hostname or literal-IP match only, never a range.
  if (allowedHosts().has(host.toLowerCase().replace(/^\[|\]$/g, ""))) return host;
  // Block literal-IP private targets without DNS lookup.
  if (host.includes(":")) {
    if (isPrivateV6(host)) throw new SsrfBlockedError("private_ipv6", { host });
  } else if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    if (isPrivateV4(host)) throw new SsrfBlockedError("private_ipv4", { host });
  } else {
    // Hostname → DNS resolve and check every answer.
    try {
      const results = await lookup(host, { all: true });
      for (const r of results) {
        if (r.family === 4 && isPrivateV4(r.address)) {
          throw new SsrfBlockedError("private_ipv4_resolved", {
            host,
            ip: r.address,
          });
        }
        if (r.family === 6 && isPrivateV6(r.address)) {
          throw new SsrfBlockedError("private_ipv6_resolved", {
            host,
            ip: r.address,
          });
        }
      }
      return results[0]?.address ?? host;
    } catch (e) {
      if (e instanceof SsrfBlockedError) throw e;
      throw new SsrfBlockedError("dns_lookup_failed", {
        host,
        cause: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return host;
}

/**
 * Wrapper around fetch() that disables auto-redirect and re-validates
 * each Location target through assertPublicHost. Use this in place of
 * fetch() for any external URL that originated from user-influenceable
 * input (e.g. captured artifacts).
 */
export async function safeFetch(
  url: string,
  init: RequestInit & { signal?: AbortSignal } = {},
  maxRedirects = 5,
): Promise<Response> {
  let current = url;
  for (let i = 0; i <= maxRedirects; i++) {
    await assertPublicHost(current);
    const res = await fetch(current, { ...init, redirect: "manual" });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) return res;
      current = new URL(loc, current).toString();
      continue;
    }
    return res;
  }
  throw new SsrfBlockedError("too_many_redirects", { url });
}
