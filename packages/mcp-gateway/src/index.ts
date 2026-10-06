import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import Database from "better-sqlite3";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildActions, dispatch } from "./actions.js";

const DB_PATH = process.env.DB_PATH ?? "./data/nosleep.db";
const SERVER_URL = process.env.NOSLEEP_SERVER_URL ?? "http://localhost:3777";

/**
 * Resolve the NoSleep API key. The interactive `.mcp.json` env is present
 * for UI/terminal-launched sessions, but cross-session / headless / cron
 * launches (the autonomous driver bound to a strategy node) don't inherit
 * that env — so the gateway would send no key and every call 401s with
 * "Invalid or missing API key" (the exact failure a headless driver hit).
 *
 * Mirror the common secrets-file pattern: fall back to a key
 * file (KEY=VALUE lines) from the first of:
 *   $NOSLEEP_MCP_ENV_FILE → ~/.config/nosleep/mcp.env → <repo>/.env
 * The file is read WITHOUT overriding an already-present env var.
 */
function resolveApiKey(): string {
  const fromEnv = process.env.NOSLEEP_API_KEY;
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv.trim();

  const candidates = [
    process.env.NOSLEEP_MCP_ENV_FILE,
    join(homedir(), ".config", "nosleep", "mcp.env"),
    join(process.cwd(), ".env"),
  ].filter((p): p is string => Boolean(p));

  for (const file of candidates) {
    try {
      if (!existsSync(file)) continue;
      const text = readFileSync(file, "utf-8");
      for (const line of text.split("\n")) {
        const m = line.match(/^\s*NOSLEEP_API_KEY\s*=\s*(.+?)\s*$/);
        if (m) {
          const val = m[1].replace(/^["']|["']$/g, "").trim();
          if (val.length > 0) return val;
        }
      }
    } catch {
      /* try next candidate */
    }
  }
  return "";
}

const API_KEY = resolveApiKey();
if (!API_KEY) {
  // Loud, permanent diagnostic — silent auth failure is what wasted the
  // headless driver's turn. Always-on, not a debug line.
  process.stderr.write(
    "[nosleep-gateway] WARNING: no NOSLEEP_API_KEY in env or secrets file " +
      "(~/.config/nosleep/mcp.env). All server calls will 401. Provision the key.\n",
  );
}

const ENV_ORG_ID = process.env.NOSLEEP_ORG_ID;
const ENV_SESSION_ID = process.env.NOSLEEP_SESSION_ID;

const db = new Database(DB_PATH, { readonly: false });
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

const actions = buildActions({
  db,
  envOrgId: ENV_ORG_ID,
  envSessionId: ENV_SESSION_ID,
  serverUrl: SERVER_URL,
  apiKey: API_KEY,
});

// ── The ONE Tool ────────────────────────────────────────

const server = new McpServer({ name: "nosleep", version: "0.2.0" });

server.tool(
  "nosleep",
  `NoSleep orchestrator — manages sessions, strategy trees, projects, alerts, and memory across all orgs (user-defined — see org_list).

Call with action="" or action="help" to list all available actions.
Call with action="search" and query="keyword" to find relevant actions.
Otherwise pass action="<name>" and params={...} to execute.`,
  {
    action: z.string().describe('Action name (e.g. "project_list", "strategy_tree", "alert_list"). Use "" or "help" to list all, "search" to find by keyword.'),
    query: z.string().optional().describe('Search keyword when action="search"'),
    params: z.record(z.unknown()).optional().describe("Parameters for the action (varies per action)"),
  },
  async ({ action, query, params }) => {
    const result = await dispatch(actions, action, query, params);
    return { content: [{ type: "text" as const, text: result.text }] };
  }
);

// ── Start ───────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
