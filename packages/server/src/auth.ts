/**
 * API key authentication middleware.
 *
 * Two modes:
 *
 * 1. **Single key (legacy)** — `NOSLEEP_API_KEY` env var. Caller sends
 *    `x-api-key: <KEY>`. Backwards compatible. `request.orgId` is null;
 *    routes still trust `body.org_id`. Suitable for single-tenant dev.
 *
 * 2. **Per-org keys (Phase 12)** — set
 *    `NOSLEEP_API_KEY_PERSONAL=<keyA>`, `NOSLEEP_API_KEY_WYOBI=<keyB>`,
 *    etc. The middleware binds the resolved org_id to `request.orgId`.
 *    Route handlers can call `assertOrgMatches(request, body.org_id)`
 *    to refuse cross-org writes. Closes the cross-org bypass surfaced
 *    in the security review.
 *
 * Constant-time compare defends against timing attacks. Exempts a small
 * allowlist of paths used by health probes, hook callbacks, the WebSocket
 * upgrade, and discovery.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { timingSafeEqual } from "node:crypto";

const HOOK_CALLBACK_PATHS = new Set([
  "/api/hooks/pre-tool",
  "/api/hooks/post-tool",
  "/api/hooks/pre-compact",
  "/api/hooks/stop",
  "/api/sessions/register",
  "/api/sessions/drain",
  "/api/brain/hook-ingest/user-prompt",
  "/api/brain/hook-ingest/pre-tool",
  "/api/brain/hook-ingest/post-tool",
  "/api/brain/hook-ingest/pre-compact",
  "/api/brain/hook-ingest/stop",
  "/api/brain/hook-ingest/transcript",
]);

const DECIDE_NEXT_RE = /^\/api\/sessions\/[^/]+\/decide-next$/;
// Stop hook calls this unauthenticated (same as decide-next) to hand off a
// delayed loop wake to the scheduler.
const SCHEDULE_WAKE_RE = /^\/api\/sessions\/[^/]+\/schedule-wake$/;
// Stop hook drains queued steering messages for connected sessions (the
// down-channel for dashboard/mobile steering of non-wrapped sessions).
const DRAIN_RE = /^\/api\/sessions\/[^/]+\/drain$/;

function constTimeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function isValidApiKey(
  provided: string | string[] | undefined,
  expected: string,
): boolean {
  if (!provided || Array.isArray(provided)) return false;
  return constTimeEq(provided, expected);
}

/** True when the request originated on this machine (loopback socket). */
export function isLoopback(ip: string | undefined): boolean {
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

function isAuthExempt(method: string, path: string, ip?: string): boolean {
  if (method === "GET") {
    if (path === "/health" || path === "/health/deep") return true;
    if (path === "/api/discovery") return true;
    if (path === "/ws") return true;
  }
  // Client error reporter is auth-exempt so first-launch failures
  // (e.g. user hasn't pasted API key yet) still surface in the server log.
  if (method === "POST" && path === "/api/client-log") return true;

  // Everything below MUTATES state (session rows, scheduler, brain ingest,
  // and /api/mcp — the full gateway incl. session_launch → spawns claude).
  // These are exempt ONLY for local processes: the server listens on
  // 0.0.0.0 for the mobile app, and 2026-08-06 security review found the
  // blanket exemptions amounted to unauthenticated LAN-reachable code
  // execution. Hooks/MCP clients on this machine hit loopback, so nothing
  // local breaks; anything remote must present the API key.
  if (!isLoopback(ip)) return false;

  if (HOOK_CALLBACK_PATHS.has(path)) return true;
  if (DECIDE_NEXT_RE.test(path)) return true;
  if (SCHEDULE_WAKE_RE.test(path)) return true;
  if (method === "POST" && DRAIN_RE.test(path)) return true;
  // Shared MCP endpoint: the StreamableHTTP transport owns the raw
  // request/response, and the gateway actions carry the key for their own
  // server calls. Exempt (loopback-only) so the MCP protocol handshake
  // isn't rejected before the transport sees it.
  if (method === "POST" && path === "/api/mcp") return true;
  return false;
}

interface PerOrgKeyMap {
  // keyValue → orgId
  [key: string]: string;
}

/**
 * Read NOSLEEP_API_KEY_<UPPER_SLUG> env vars and return a key→orgId
 * lookup. Slugs map to org_ids: PERSONAL → org_personal, WYOBI →
 * org_wyobi, APPLY → org_apply.
 */
function buildPerOrgKeyMap(): PerOrgKeyMap {
  const map: PerOrgKeyMap = {};
  for (const slug of ["personal", "wyobi", "apply"] as const) {
    const env = `NOSLEEP_API_KEY_${slug.toUpperCase()}`;
    const v = process.env[env];
    if (v && v.length >= 16) map[v] = `org_${slug}`;
  }
  return map;
}

declare module "fastify" {
  interface FastifyRequest {
    /** Resolved org_id when per-org auth mode is in use; null otherwise. */
    orgId: string | null;
  }
}

/**
 * Helper for routes that take `org_id` in the body. Returns `true` if
 * the request's bound orgId (from the per-org key) matches — or if the
 * server is in single-key legacy mode (no binding to enforce).
 */
export function assertOrgMatches(
  request: FastifyRequest,
  reply: FastifyReply,
  bodyOrgId: string,
): boolean {
  if (!request.orgId) return true; // single-key mode: not bound, trust caller
  if (request.orgId === bodyOrgId) return true;
  reply.status(403).send({
    success: false,
    error: `cross-org access denied: key bound to ${request.orgId}, request targeted ${bodyOrgId}`,
  });
  return false;
}

export function registerAuth(
  fastify: FastifyInstance,
  apiKey: string | undefined,
): void {
  const perOrgKeys = buildPerOrgKeyMap();
  const hasPerOrg = Object.keys(perOrgKeys).length > 0;

  // Skip auth entirely if no keys are configured (local dev mode).
  if (!apiKey && !hasPerOrg) {
    fastify.addHook("preHandler", async (request) => {
      request.orgId = null;
    });
    return;
  }

  fastify.addHook("preHandler", async (request, reply) => {
    request.orgId = null;
    const path = request.url.split("?")[0];
    if (isAuthExempt(request.method, path, request.ip)) return;
    const provided = request.headers["x-api-key"];
    if (!provided || Array.isArray(provided)) {
      return reply
        .status(401)
        .send({ success: false, error: "Invalid or missing API key" });
    }

    // Try per-org keys first — match in constant time across the map.
    if (hasPerOrg) {
      let matchedOrg: string | null = null;
      for (const [key, orgId] of Object.entries(perOrgKeys)) {
        if (constTimeEq(provided, key)) {
          matchedOrg = orgId;
          break;
        }
      }
      if (matchedOrg) {
        request.orgId = matchedOrg;
        return;
      }
    }

    // Fall back to the global key for backwards compatibility.
    if (apiKey && isValidApiKey(provided, apiKey)) {
      return; // request.orgId stays null — legacy mode, no binding
    }

    return reply
      .status(401)
      .send({ success: false, error: "Invalid or missing API key" });
  });
}

// Exported for testing only
export const _internal = { isValidApiKey, isAuthExempt, buildPerOrgKeyMap };
