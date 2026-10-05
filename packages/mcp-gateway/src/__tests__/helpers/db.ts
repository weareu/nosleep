import { initializeDatabase } from "../../../../server/src/db/schema.js";
import Database from "better-sqlite3";

export function createTestDb(): Database.Database {
  const db = initializeDatabase(":memory:");
  return db;
}

export function seedGatewayData(db: Database.Database): {
  orgPersonalId: string;
  orgWyobiId: string;
  accountPersonalId: string;
  accountWyobiId: string;
  projectPersonalId: string;
  projectWyobiId: string;
  strategyRootId: string;
  strategyChildId: string;
  alertId1: number;
  alertId2: number;
  memoryId1: string;
  memoryId2: string;
} {
  // Orgs are already seeded by initializeDatabase

  // Accounts
  db.prepare(`INSERT INTO accounts (id, org_id, name, type, daily_token_limit) VALUES (?, ?, ?, ?, ?)`).run(
    "acc_personal_1", "org_personal", "Personal Pro", "pro", 10000000
  );
  db.prepare(`INSERT INTO accounts (id, org_id, name, type, daily_token_limit) VALUES (?, ?, ?, ?, ?)`).run(
    "acc_wyobi_1", "org_wyobi", "Wyobi Team", "team", 20000000
  );

  // Projects
  db.prepare(`INSERT INTO projects (id, org_id, name, path, account_id, token_budget, autonomy_level, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    "proj_personal_1", "org_personal", "My Side Project", "/Users/test/side-project", "acc_personal_1", 500000, "supervised", "idle"
  );
  db.prepare(`INSERT INTO projects (id, org_id, name, path, account_id, token_budget, autonomy_level, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    "proj_wyobi_1", "org_wyobi", "Work Dashboard", "/Users/test/work-dash", "acc_wyobi_1", 1000000, "full", "running"
  );

  // Strategy nodes (root + child for personal project)
  db.prepare(`INSERT INTO strategy_nodes (id, project_id, org_id, parent_id, type, title, description, status, progress_pct, depth, sort_order, dependencies, acceptance_criteria, weight, estimated_tokens) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    "strat_root_1", "proj_personal_1", "org_personal", null, "strategy", "Build MVP", "Ship the minimum viable product", "in_progress", 25, 0, 0, "[]", "[]", 1, 0
  );
  db.prepare(`INSERT INTO strategy_nodes (id, project_id, org_id, parent_id, type, title, description, status, progress_pct, depth, sort_order, dependencies, acceptance_criteria, weight, estimated_tokens) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    "strat_child_1", "proj_personal_1", "org_personal", "strat_root_1", "task", "Setup CI/CD", "Configure GitHub Actions", "pending", 0, 1, 0, "[]", '["Pipeline runs on push","Tests pass"]', 1, 50000
  );

  // Alerts
  db.prepare(`INSERT INTO alerts (org_id, session_id, type, severity, message, acknowledged) VALUES (?, ?, ?, ?, ?, ?)`).run(
    "org_personal", null, "drift", "warning", "Session drifted from goal", 0
  );
  db.prepare(`INSERT INTO alerts (org_id, session_id, type, severity, message, acknowledged) VALUES (?, ?, ?, ?, ?, ?)`).run(
    "org_personal", null, "budget", "critical", "Token budget exceeded 90%", 0
  );
  // Get alert IDs
  const alerts = db.prepare(`SELECT id FROM alerts WHERE org_id = 'org_personal' ORDER BY id`).all() as Array<{ id: number }>;

  // Wyobi alert (for isolation test)
  db.prepare(`INSERT INTO alerts (org_id, session_id, type, severity, message, acknowledged) VALUES (?, ?, ?, ?, ?, ?)`).run(
    "org_wyobi", null, "error", "critical", "Build failed in work project", 0
  );

  // Memory entries
  db.prepare(`INSERT INTO memory (id, org_id, project_id, category, key, value, access_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`).run(
    "mem_1", "org_personal", null, "decision", "use-sqlite", "Chose SQLite for local-first architecture", 5
  );
  db.prepare(`INSERT INTO memory (id, org_id, project_id, category, key, value, access_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`).run(
    "mem_2", "org_personal", "proj_personal_1", "skill", "vitest-config", "Use vitest with node environment for server tests", 2
  );
  // Wyobi memory (for isolation test)
  db.prepare(`INSERT INTO memory (id, org_id, project_id, category, key, value, access_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`).run(
    "mem_wyobi_1", "org_wyobi", null, "fact", "deploy-target", "Deploy to Kubernetes cluster in us-east-1", 1
  );

  return {
    orgPersonalId: "org_personal",
    orgWyobiId: "org_wyobi",
    accountPersonalId: "acc_personal_1",
    accountWyobiId: "acc_wyobi_1",
    projectPersonalId: "proj_personal_1",
    projectWyobiId: "proj_wyobi_1",
    strategyRootId: "strat_root_1",
    strategyChildId: "strat_child_1",
    alertId1: alerts[0].id,
    alertId2: alerts[1].id,
    memoryId1: "mem_1",
    memoryId2: "mem_2",
  };
}
