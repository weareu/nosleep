/**
 * The complete, ordered list of NoSleep DB migrations.
 *
 * Add a new migration: append a new entry with the next sequential `version`.
 * Never reuse or reorder versions — `runMigrations` enforces strict ascending.
 *
 * Every up() must be IDEMPOTENT (use IF NOT EXISTS / safeAlter) so that DBs
 * predating the migration framework can run all of them on the first boot
 * without error.
 */

import type Database from "better-sqlite3";
import type { Migration } from "./migrations.js";
import { safeAlter } from "./migrations.js";

const DEFAULT_ITERATION_STEPS_JSON = JSON.stringify([
  { id: 1, label: "Document goal/spec", description: "Write clear specification of what needs to be done", gated: false },
  { id: 2, label: "Implement", description: "Write the core implementation code", gated: false },
  { id: 3, label: "Write tests", description: "Write tests that actually find bugs, not just pass — useful tests", gated: false },
  { id: 4, label: "Implement wiring", description: "Wire up integrations, connect components, add routes/handlers", gated: false },
  { id: 5, label: "Wiring and E2E tests", description: "End-to-end tests verifying the full integration works", gated: false },
  { id: 6, label: "Review", description: "Code review for quality, security, and correctness", gated: true },
  { id: 7, label: "Update documentation", description: "Update docs, project artifacts, review for consistency", gated: false },
  { id: 8, label: "Pre-check test runs", description: "Run all tests via hooks or manually before commit", gated: true },
  { id: 9, label: "Check in / push / build", description: "Commit, push, and verify build passes (if applicable)", gated: true },
]).replace(/'/g, "''");

/**
 * Run a multi-statement SQL script (split on `;` boundaries — naive but
 * sufficient because none of our embedded SQL contains semicolons inside
 * string literals or comments).
 */
function runMultiStatement(db: Database.Database, sql: string): void {
  const statements = sql
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith("--"));
  for (const stmt of statements) {
    try {
      db.prepare(stmt).run();
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes("duplicate column")) continue;
      throw err;
    }
  }
}

const INITIAL_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  color TEXT NOT NULL DEFAULT '#6366f1',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO organizations (id, name, slug, color) VALUES
  ('org_personal', 'Personal', 'personal', '#6366f1');

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('pro', 'max', 'team', 'api')),
  api_key_ref TEXT,
  daily_token_limit INTEGER NOT NULL DEFAULT 10000000,
  monthly_token_limit INTEGER NOT NULL DEFAULT 200000000,
  billing_cycle_day INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  token_budget INTEGER NOT NULL DEFAULT 500000,
  autonomy_level TEXT NOT NULL DEFAULT 'supervised' CHECK(autonomy_level IN ('full', 'supervised', 'manual')),
  status TEXT NOT NULL DEFAULT 'idle' CHECK(status IN ('idle', 'running', 'paused', 'error')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  pid INTEGER,
  status TEXT NOT NULL DEFAULT 'starting' CHECK(status IN ('starting', 'running', 'idle', 'waiting_input', 'paused', 'completed', 'failed', 'stopped')),
  goal_text TEXT NOT NULL,
  goal_hash TEXT NOT NULL,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at TEXT,
  tokens_used INTEGER NOT NULL DEFAULT 0,
  last_activity_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS goals (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  objective TEXT NOT NULL,
  acceptance_criteria TEXT NOT NULL DEFAULT '[]',
  current_phase TEXT NOT NULL DEFAULT 'initial',
  progress_pct INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS strategy_nodes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  org_id TEXT NOT NULL REFERENCES organizations(id),
  parent_id TEXT REFERENCES strategy_nodes(id),
  type TEXT NOT NULL CHECK(type IN ('strategy', 'goal', 'task', 'subtask')),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'in_progress', 'completed', 'blocked', 'skipped')),
  progress_pct INTEGER NOT NULL DEFAULT 0,
  depth INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  assigned_session_id TEXT REFERENCES sessions(id),
  dependencies TEXT NOT NULL DEFAULT '[]',
  priority INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS push_devices (
  id TEXT PRIMARY KEY,
  push_token TEXT NOT NULL UNIQUE,
  org_filter TEXT,
  platform TEXT DEFAULT 'ios',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS token_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  model TEXT NOT NULL DEFAULT 'unknown',
  recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  session_id TEXT REFERENCES sessions(id),
  project_id TEXT REFERENCES projects(id),
  type TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info' CHECK(severity IN ('info', 'warning', 'critical')),
  message TEXT NOT NULL,
  acknowledged INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS validations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  goal_id TEXT NOT NULL REFERENCES goals(id),
  verdict TEXT CHECK(verdict IN ('complete', 'incomplete', 'stub')),
  details TEXT,
  validator_model TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS memory (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  project_id TEXT,
  category TEXT NOT NULL CHECK(category IN ('skill', 'decision', 'pattern', 'fact')),
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  embedding BLOB,
  access_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(org_id, project_id, category, key)
);

CREATE TABLE IF NOT EXISTS research_notebooks (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  project_id TEXT REFERENCES projects(id),
  notebook_lm_id TEXT NOT NULL,
  title TEXT NOT NULL,
  source_count INTEGER NOT NULL DEFAULT 0,
  last_queried_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS research_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  notebook_id TEXT REFERENCES research_notebooks(id),
  query TEXT NOT NULL,
  response_summary TEXT,
  sources_cited INTEGER DEFAULT 0,
  estimated_tokens_saved INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

const POST_INDEXES_SQL = `
CREATE INDEX IF NOT EXISTS idx_accounts_org ON accounts(org_id);
CREATE INDEX IF NOT EXISTS idx_projects_org ON projects(org_id);
CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_token_usage_account_date ON token_usage(account_id, recorded_at);
CREATE INDEX IF NOT EXISTS idx_token_usage_project ON token_usage(project_id, recorded_at);
CREATE INDEX IF NOT EXISTS idx_alerts_org ON alerts(org_id, acknowledged, created_at);
CREATE INDEX IF NOT EXISTS idx_alerts_unacked ON alerts(acknowledged, created_at);
CREATE INDEX IF NOT EXISTS idx_strategy_project ON strategy_nodes(project_id);
CREATE INDEX IF NOT EXISTS idx_strategy_parent ON strategy_nodes(parent_id);
CREATE INDEX IF NOT EXISTS idx_strategy_org ON strategy_nodes(org_id);
CREATE INDEX IF NOT EXISTS idx_strategy_session ON strategy_nodes(assigned_session_id);
CREATE INDEX IF NOT EXISTS idx_memory_org ON memory(org_id, category);
CREATE INDEX IF NOT EXISTS idx_memory_org_project ON memory(org_id, project_id, category);
CREATE INDEX IF NOT EXISTS idx_research_notebooks_org ON research_notebooks(org_id);
CREATE INDEX IF NOT EXISTS idx_research_log_org ON research_log(org_id, created_at);
`;

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "initial_schema",
    up: (db) => runMultiStatement(db, INITIAL_SCHEMA_SQL),
  },
  {
    version: 2,
    name: "projects_continue_session",
    up: (db) => safeAlter(db, `ALTER TABLE projects ADD COLUMN continue_session INTEGER NOT NULL DEFAULT 0`),
  },
  {
    version: 3,
    name: "sessions_claude_session_id",
    up: (db) => safeAlter(db, `ALTER TABLE sessions ADD COLUMN claude_session_id TEXT`),
  },
  {
    version: 4,
    name: "sessions_cost_usd",
    up: (db) => safeAlter(db, `ALTER TABLE sessions ADD COLUMN cost_usd REAL NOT NULL DEFAULT 0`),
  },
  {
    version: 5,
    name: "accounts_monthly_budget_usd",
    up: (db) => safeAlter(db, `ALTER TABLE accounts ADD COLUMN monthly_budget_usd REAL NOT NULL DEFAULT 200.0`),
  },
  {
    version: 6,
    name: "projects_iteration_steps",
    up: (db) => safeAlter(db, `ALTER TABLE projects ADD COLUMN iteration_steps TEXT NOT NULL DEFAULT '${DEFAULT_ITERATION_STEPS_JSON}'`),
  },
  {
    version: 7,
    name: "strategy_acceptance_criteria",
    up: (db) => safeAlter(db, `ALTER TABLE strategy_nodes ADD COLUMN acceptance_criteria TEXT NOT NULL DEFAULT '[]'`),
  },
  {
    version: 8,
    name: "strategy_weight",
    up: (db) => safeAlter(db, `ALTER TABLE strategy_nodes ADD COLUMN weight INTEGER NOT NULL DEFAULT 1`),
  },
  {
    version: 9,
    name: "strategy_estimated_tokens",
    up: (db) => safeAlter(db, `ALTER TABLE strategy_nodes ADD COLUMN estimated_tokens INTEGER NOT NULL DEFAULT 0`),
  },
  {
    version: 10,
    name: "session_events",
    up: (db) => runMultiStatement(db, `
      CREATE TABLE IF NOT EXISTS session_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        event_type TEXT NOT NULL,
        payload TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_session_events_session ON session_events(session_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_session_events_type ON session_events(session_id, event_type);
      CREATE INDEX IF NOT EXISTS idx_session_events_escalation ON session_events(event_type) WHERE event_type = 'escalation_created';
    `),
  },
  {
    version: 11,
    name: "session_messages",
    up: (db) => runMultiStatement(db, `
      CREATE TABLE IF NOT EXISTS session_messages (
        id TEXT PRIMARY KEY,
        from_session_id TEXT NOT NULL REFERENCES sessions(id),
        to_session_id TEXT,
        org_id TEXT NOT NULL REFERENCES organizations(id),
        type TEXT NOT NULL CHECK(type IN ('discovery', 'request', 'handoff', 'conflict', 'info')),
        payload TEXT NOT NULL,
        read INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_session_messages_to ON session_messages(to_session_id, read);
      CREATE INDEX IF NOT EXISTS idx_session_messages_org ON session_messages(org_id, created_at);
    `),
  },
  {
    version: 12,
    name: "file_locks",
    up: (db) => runMultiStatement(db, `
      CREATE TABLE IF NOT EXISTS file_locks (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        org_id TEXT NOT NULL REFERENCES organizations(id),
        file_path TEXT NOT NULL,
        locked_at TEXT NOT NULL DEFAULT (datetime('now')),
        released_at TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_file_locks_active ON file_locks(file_path, org_id) WHERE released_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_file_locks_session ON file_locks(session_id) WHERE released_at IS NULL;
    `),
  },
  {
    version: 13,
    name: "model_routing",
    up: (db) => {
      safeAlter(db, `ALTER TABLE projects ADD COLUMN default_model TEXT DEFAULT 'opus'`);
      safeAlter(db, `ALTER TABLE strategy_nodes ADD COLUMN recommended_model TEXT`);
      safeAlter(db, `ALTER TABLE sessions ADD COLUMN model TEXT`);
    },
  },
  {
    version: 14,
    name: "projects_active_flag",
    up: (db) => safeAlter(db, `ALTER TABLE projects ADD COLUMN active INTEGER NOT NULL DEFAULT 1`),
  },
  {
    version: 15,
    name: "session_fork_retry",
    up: (db) => {
      safeAlter(db, `ALTER TABLE sessions ADD COLUMN parent_session_id TEXT REFERENCES sessions(id)`);
      safeAlter(db, `ALTER TABLE sessions ADD COLUMN failure_mode TEXT`);
      safeAlter(db, `ALTER TABLE sessions ADD COLUMN failure_summary TEXT`);
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions(parent_session_id)`).run();
    },
  },
  {
    version: 16,
    name: "sessions_org_id_denormalized",
    up: (db) => {
      safeAlter(db, `ALTER TABLE sessions ADD COLUMN org_id TEXT REFERENCES organizations(id)`);
      // Backfill from projects
      db.prepare(`UPDATE sessions SET org_id = (SELECT p.org_id FROM projects p WHERE p.id = sessions.project_id) WHERE org_id IS NULL`).run();
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_sessions_org ON sessions(org_id)`).run();
    },
  },
  {
    version: 17,
    name: "strategy_source_ref_priority_timing",
    up: (db) => {
      safeAlter(db, `ALTER TABLE strategy_nodes ADD COLUMN source_ref TEXT`);
      safeAlter(db, `ALTER TABLE strategy_nodes ADD COLUMN priority INTEGER DEFAULT 3`);
      safeAlter(db, `ALTER TABLE strategy_nodes ADD COLUMN started_at TEXT`);
      safeAlter(db, `ALTER TABLE strategy_nodes ADD COLUMN completed_at TEXT`);
    },
  },
  {
    version: 18,
    name: "plan_index_fts5",
    up: (db) => {
      db.prepare(`CREATE VIRTUAL TABLE IF NOT EXISTS plan_index USING fts5(
        project_id UNINDEXED,
        file_path UNINDEXED,
        line_number UNINDEXED,
        heading,
        content,
        tokenize='porter unicode61'
      )`).run();
      db.prepare(`CREATE TABLE IF NOT EXISTS plan_files (
        project_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        file_hash TEXT NOT NULL,
        indexed_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (project_id, file_path)
      )`).run();
    },
  },
  {
    version: 19,
    name: "scheduled_tasks",
    up: (db) => runMultiStatement(db, `
      CREATE TABLE IF NOT EXISTS scheduled_tasks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        org_id TEXT NOT NULL REFERENCES organizations(id),
        name TEXT NOT NULL,
        cron_hour INTEGER NOT NULL,
        cron_minute INTEGER NOT NULL DEFAULT 0,
        days_of_week TEXT NOT NULL DEFAULT '1,2,3,4,5',
        goal_template TEXT NOT NULL,
        task_type TEXT NOT NULL DEFAULT 'review',
        enabled INTEGER NOT NULL DEFAULT 1,
        last_run_at TEXT,
        next_run_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_project ON scheduled_tasks(project_id);
      CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_next ON scheduled_tasks(enabled, next_run_at);
    `),
  },
  {
    version: 20,
    name: "post_indexes",
    up: (db) => runMultiStatement(db, POST_INDEXES_SQL),
  },
  // Phase 22-B — worktree alignment + session→strategy node tagging.
  // Sessions running on a git worktree register against the worktree
  // path, but the parent project is the canonical repo. We now store
  // both: project_id stays canonical, worktree_path captures the runtime
  // cwd. strategy_node_id holds the currently-assigned task so the
  // dashboard can show "this session is working on X".
  {
    version: 21,
    name: "session_worktree_and_strategy",
    up: (db) => {
      safeAlter(db, `ALTER TABLE sessions ADD COLUMN worktree_path TEXT`);
      safeAlter(db, `ALTER TABLE sessions ADD COLUMN strategy_node_id TEXT`);
      safeAlter(db, `CREATE INDEX IF NOT EXISTS idx_sessions_strategy ON sessions(strategy_node_id)`);
    },
  },
  // Phase 22-C — cross-tree strategy ref-links. Distinct from
  // `dependencies` (which is blocking-order FS/SS/FF/SF). These are
  // semantic links: "this node is related to / informs / supersedes /
  // references that one", including across projects. Powers the new
  // strategy graph view and the Karpathy-style cross-link discipline.
  {
    version: 22,
    name: "strategy_node_refs",
    up: (db) => runMultiStatement(db, `
      CREATE TABLE IF NOT EXISTS strategy_node_refs (
        id TEXT PRIMARY KEY,
        from_id TEXT NOT NULL REFERENCES strategy_nodes(id) ON DELETE CASCADE,
        to_id TEXT NOT NULL REFERENCES strategy_nodes(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK(kind IN ('related','informs','supersedes','references')),
        weight REAL NOT NULL DEFAULT 1.0,
        note TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(from_id, to_id, kind)
      );
      CREATE INDEX IF NOT EXISTS idx_snrefs_from ON strategy_node_refs(from_id);
      CREATE INDEX IF NOT EXISTS idx_snrefs_to   ON strategy_node_refs(to_id);
    `),
  },
  // Loop redesign — scheduled_tasks gains interval + one-shot modes so the
  // same scheduler that runs cron reviews can also run time-based loops
  // ("wake every N minutes and process the strategy tree", matching
  // Claude-native /loop Nm) and one-shot delayed wakes (the interactive
  // Stop-hook loop hands off here instead of hammering immediately).
  //   mode='cron'     → existing hour/minute/days behaviour (default).
  //   mode='interval' → fire every `interval_minutes`, from last_run + N.
  //   oneshot=1       → run once then auto-disable (used by schedule-wake).
  //   strategy_mode='next_actionable' → inject the next strat-tree task
  //                     instead of the review goal_template.
  {
    version: 23,
    name: "scheduled_tasks_interval_mode",
    up: (db) => {
      safeAlter(db, `ALTER TABLE scheduled_tasks ADD COLUMN mode TEXT NOT NULL DEFAULT 'cron'`);
      safeAlter(db, `ALTER TABLE scheduled_tasks ADD COLUMN interval_minutes INTEGER`);
      safeAlter(db, `ALTER TABLE scheduled_tasks ADD COLUMN oneshot INTEGER NOT NULL DEFAULT 0`);
      safeAlter(db, `ALTER TABLE scheduled_tasks ADD COLUMN strategy_mode TEXT NOT NULL DEFAULT 'template'`);
    },
  },
  {
    version: 24,
    name: "project_loops",
    up: (db) => {
      // Per-project autonomous-loop config, AI-controllable via the nosleep
      // gateway (loop_set/loop_status/loop_stop). Replaces the opaque
      // .nosleep-loop-active file as the source of truth for HOW the loop
      // behaves (the file stays only as a legacy on/off hint).
      db.prepare(`
        CREATE TABLE IF NOT EXISTS project_loops (
          project_id TEXT PRIMARY KEY REFERENCES projects(id),
          enabled INTEGER NOT NULL DEFAULT 0,
          mode TEXT NOT NULL DEFAULT 'continue' CHECK(mode IN ('continue','content','branch')),
          content TEXT,
          linked_node_id TEXT,
          interval_minutes INTEGER NOT NULL DEFAULT 10,
          last_target_id TEXT,
          no_progress_count INTEGER NOT NULL DEFAULT 0,
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `).run();
    },
  },
  {
    version: 25,
    name: "organizations_user_defined",
    // Older installs created `organizations` with a CHECK constraint pinning
    // slug to a fixed list. Orgs are user-defined now, so rebuild the table
    // without it — preserving every row and id exactly. SQLite cannot drop a
    // constraint in place; the documented 12-step rebuild needs foreign keys
    // OFF (8 tables reference organizations(id)), which the runner handles
    // and follows with a foreign_key_check before committing.
    foreignKeysOff: true,
    up: (db) => {
      const row = db
        .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'organizations'`)
        .get() as { sql: string } | undefined;
      if (!row || !/CHECK\s*\(/i.test(row.sql)) return; // already unconstrained
      db.prepare(`DROP TABLE IF EXISTS organizations_rebuild`).run();
      db.prepare(`
        CREATE TABLE organizations_rebuild (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          slug TEXT NOT NULL UNIQUE,
          color TEXT NOT NULL DEFAULT '#6366f1',
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `).run();
      db.prepare(`
        INSERT INTO organizations_rebuild (id, name, slug, color, created_at)
        SELECT id, name, slug, color, created_at FROM organizations
      `).run();
      db.prepare(`DROP TABLE organizations`).run();
      db.prepare(`ALTER TABLE organizations_rebuild RENAME TO organizations`).run();
    },
  },
];
