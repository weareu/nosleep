import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import Database from "better-sqlite3";
import { storeMemory, retrieveMemory, listMemory, deleteMemory } from "./memory-ops.js";

const DB_PATH = process.env.DB_PATH ?? "./data/nosleep.db";
const ORG_ID = process.env.NOSLEEP_ORG_ID;

if (!ORG_ID) {
  console.error("FATAL: NOSLEEP_ORG_ID is required. Memory MCP must be scoped to an organization.");
  process.exit(1);
}

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// Verify the org exists
const org = db.prepare(`SELECT id, name, slug FROM organizations WHERE id = ?`).get(ORG_ID) as
  { id: string; name: string; slug: string } | undefined;
if (!org) {
  console.error(`FATAL: Organization '${ORG_ID}' not found in database.`);
  process.exit(1);
}

const server = new McpServer({
  name: `nosleep-memory-${org.slug}`,
  version: "0.1.0",
});

// ── memory_store ────────────────────────────────────────

server.tool(
  "memory_store",
  `Store a fact, decision, pattern, or skill in ${org.name} organization memory. NEVER stores data accessible to other organizations.`,
  {
    category: z.enum(["skill", "decision", "pattern", "fact"]),
    key: z.string().describe("Short identifier for this memory"),
    value: z.string().describe("The content to remember"),
    project: z.string().optional().describe("Project ID, omit for org-wide"),
  },
  async ({ category, key, value, project }) => {
    return storeMemory(db, ORG_ID, { category, key, value, project });
  }
);

// ── memory_retrieve ─────────────────────────────────────

server.tool(
  "memory_retrieve",
  `Search for memories within ${org.name} organization by keyword. Only returns memories belonging to this org.`,
  {
    query: z.string().describe("Search keywords"),
    category: z.enum(["skill", "decision", "pattern", "fact"]).optional(),
    project: z.string().optional().describe("Filter by project ID"),
    limit: z.number().default(10),
  },
  async ({ query, category, project, limit }) => {
    return retrieveMemory(db, ORG_ID, { query, category, project, limit });
  }
);

// ── memory_list ─────────────────────────────────────────

server.tool(
  "memory_list",
  `List all memories in ${org.name} organization, optionally filtered by category or project`,
  {
    category: z.enum(["skill", "decision", "pattern", "fact"]).optional(),
    project: z.string().optional(),
  },
  async ({ category, project }) => {
    return listMemory(db, ORG_ID, { category, project });
  }
);

// ── memory_delete ───────────────────────────────────────

server.tool(
  "memory_delete",
  "Delete a memory entry by ID (only within this organization)",
  {
    id: z.string(),
  },
  async ({ id }) => {
    return deleteMemory(db, ORG_ID, { id });
  }
);

// ── Start server ────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
