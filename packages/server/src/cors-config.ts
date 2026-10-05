/**
 * CORS origin validator. Allows the well-known dev/runtime ports (5173
 * dashboard, 3777 server, 19006 expo) — but only on local or private-network
 * hosts. Port-only matching let ANY internet hostname on :5173 through
 * (2026-08-06 security review M4): a malicious page served on a matching
 * port could drive the API from a victim's browser.
 *
 * Wildcard origin is intentionally never used.
 */

import type { FastifyCorsOptions } from "@fastify/cors";

export const ALLOWED_CORS_PORTS = new Set([5173, 3777, 19006]);

/** Loopback, RFC1918 private ranges, link-local, .local mDNS, Tailscale CGNAT. */
export function isLocalOrPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]") return true;
  if (h.endsWith(".local")) return true;
  if (/^10\.\d+\.\d+\.\d+$/.test(h)) return true;
  if (/^192\.168\.\d+\.\d+$/.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(h)) return true;
  if (/^169\.254\.\d+\.\d+$/.test(h)) return true; // link-local
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+$/.test(h)) return true; // Tailscale CGNAT
  return false;
}

export const corsOptions: FastifyCorsOptions = {
  origin: (origin, cb) => {
    if (!origin) {
      cb(null, true); // same-origin / non-browser requests
      return;
    }
    try {
      const parsed = new URL(origin);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        cb(null, false);
        return;
      }
      const port = parsed.port
        ? parseInt(parsed.port, 10)
        : (parsed.protocol === "https:" ? 443 : 80);
      cb(null, ALLOWED_CORS_PORTS.has(port) && isLocalOrPrivateHost(parsed.hostname));
    } catch {
      cb(null, false);
    }
  },
};
