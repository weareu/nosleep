/**
 * Shared, in-process MCP endpoint over HTTP.
 *
 * The per-need pattern: instead of every Claude Code session spawning its
 * own stdio subprocess fleet (npx tsx × N servers, each carrying node +
 * tsx loader + sqlite mmap — the memory/proc explosion), all sessions
 * connect to THIS one endpoint hosted by the already-running server.
 * Zero subprocesses per session. Heavy backends (brain DBs, embedder)
 * lazy-init inside the server on first use and can be torn down on idle.
 *
 * Transport: StreamableHTTP in STATELESS mode — a fresh transport+server
 * per request, so there's no cross-session state to leak and no session
 * table to manage. The single `nosleep` action-tool keeps the token cost
 * to one schema regardless of how many capabilities sit behind it.
 *
 * Mounted at POST /api/mcp (behind the existing x-api-key auth). Point a
 * project's .mcp.json at it with:
 *   { "type": "http", "url": "http://localhost:3777/api/mcp",
 *     "headers": { "x-api-key": "<key>" } }
 */

import type { FastifyInstance } from "fastify";
import type { IncomingHttpHeaders } from "node:http";
import type Database from "better-sqlite3";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { getSessionOrg } from "@nosleep/shared";
import { buildActions, dispatch } from "../../../mcp-gateway/src/actions.js";

interface HttpMcpDeps {
  db: Database.Database;
  serverUrl: string;
  apiKey: string;
}

interface TrustedBinding {
  orgId?: string;
  sessionId?: string;
}

function headerStr(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}

/**
 * Derive the caller's TRUSTED org from request headers. Two trust sources,
 * strongest first:
 *  1. `x-nosleep-session-id` → look up sessions.org_id (the session's org was
 *     set by the system at launch/register, so it can't be forged by passing
 *     a tool param — only by knowing a real session id of the target org).
 *  2. `x-nosleep-org` → a project's org baked into its .mcp.json by the hook
 *     installer; validated against the organizations table.
 * Absent both, returns {} and the gateway falls back to caller-supplied orgId
 * (backward compatible for unbound dashboard/admin contexts).
 */
function resolveTrustedBinding(headers: IncomingHttpHeaders, db: Database.Database): TrustedBinding {
  const sessionId = headerStr(headers["x-nosleep-session-id"]);
  if (sessionId) {
    const org = getSessionOrg(db, sessionId);
    if (org) return { orgId: org, sessionId };
  }
  const orgHeader = headerStr(headers["x-nosleep-org"]);
  if (orgHeader) {
    const exists = db.prepare(`SELECT 1 FROM organizations WHERE id = ?`).get(orgHeader);
    if (exists) return { orgId: orgHeader, sessionId };
  }
  return { sessionId };
}

/**
 * Build a fresh McpServer wired to the gateway action set. Created per
 * request in stateless mode. org/session are not baked — every action
 * carries its own org/project params (the gateway resolves them), which
 * is exactly what makes one shared endpoint safe across all orgs.
 */
function buildMcpServer(deps: HttpMcpDeps, trusted: TrustedBinding): McpServer {
  const actions = buildActions({
    db: deps.db,
    envOrgId: trusted.orgId,
    envSessionId: trusted.sessionId,
    serverUrl: deps.serverUrl,
    apiKey: deps.apiKey,
  });

  const server = new McpServer({ name: "nosleep", version: "0.3.0" });
  server.tool(
    "nosleep",
    `NoSleep orchestrator — sessions, strategy trees, projects, alerts, memory, and brain (archive/thoughts/graph) across all orgs.

Call action="" or "help" to list actions, action="search" + query to find by keyword, else action="<name>" with params={...}.`,
    {
      action: z.string().describe('Action name. "" or "help" lists all; "search" finds by keyword.'),
      query: z.string().optional().describe('Search keyword when action="search"'),
      params: z.record(z.unknown()).optional().describe("Parameters for the action"),
    },
    async ({ action, query, params }) => {
      const result = await dispatch(actions, action, query, params);
      return { content: [{ type: "text" as const, text: result.text }] };
    },
  );
  return server;
}

export function registerHttpMcp(fastify: FastifyInstance, deps: HttpMcpDeps): void {
  fastify.post("/api/mcp", async (request, reply) => {
    // Stateless: a fresh server+transport per request avoids any
    // cross-request state. sessionIdGenerator: undefined = stateless.
    // Per-request trusted-org binding from headers — see resolveTrustedBinding.
    const trusted = resolveTrustedBinding(request.headers, deps.db);
    const server = buildMcpServer(deps, trusted);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    reply.raw.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    // Hand the raw node req/res to the SDK; tell Fastify we own the response.
    reply.hijack();
    await transport.handleRequest(request.raw, reply.raw, request.body);
  });
}
